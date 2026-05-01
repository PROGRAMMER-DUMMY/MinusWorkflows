use candle_core::{Device, Tensor};
use candle_transformers::models::distilbert::{Config, DistilBertModel};
use hf_hub::{api::sync::Api, Repo, RepoType};
use tokenizers::Tokenizer;
use regex::Regex;
use std::collections::HashMap;
use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct NerConfig {
    #[serde(flatten)]
    base: Config,
    num_labels: usize,
    id2label: HashMap<String, String>,
}

pub struct SmartScrubber {
    model: DistilBertModel,
    tokenizer: Tokenizer,
    device: Device,
    label_map: HashMap<u32, String>,
    classifier_weights: Tensor,
    classifier_bias: Tensor,
}

impl SmartScrubber {
    pub fn scrub(&self, text: &str) -> String {
        let mut redacted_text = text.to_string();

        // 1. Regex Pass
        redacted_text = self.regex_pass(&redacted_text);

        // 2. Smart Pass (NER)
        redacted_text = self.smart_pass(&redacted_text);

        redacted_text
    }

    fn regex_pass(&self, text: &str) -> String {
        let email_regex = Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap();
        let ip_regex = Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap();
        let secret_regex = Regex::new(r"sk-[a-zA-Z0-9]{32}").unwrap();

        let mut result = text.to_string();
        result = email_regex.replace_all(&result, "[REDACTED]").to_string();
        result = ip_regex.replace_all(&result, "[REDACTED]").to_string();
        result = secret_regex.replace_all(&result, "[REDACTED]").to_string();
        result
    }

    fn smart_pass(&self, text: &str) -> String {
        if text.is_empty() {
            return text.to_string();
        }

        let tokens = match self.tokenizer.encode(text, true) {
            Ok(t) => t,
            Err(_) => return text.to_string(),
        };

        let input_ids = tokens.get_ids();
        let input_ids_tensor = match Tensor::new(input_ids, &self.device) {
            Ok(t) => match t.unsqueeze(0) {
                Ok(t) => t,
                Err(_) => return text.to_string(),
            },
            Err(_) => return text.to_string(),
        };

        // DistilBert forward takes input_ids and attention_mask
        let attention_mask = match input_ids_tensor.ones_like() {
            Ok(t) => t,
            Err(_) => return text.to_string(),
        };

        let output = match self.model.forward(&input_ids_tensor, &attention_mask) {
            Ok(t) => t,
            Err(_) => return text.to_string(),
        };

        // Apply classification head
        let logits = match output.matmul(&self.classifier_weights.t().unwrap()) {
            Ok(t) => match t.broadcast_add(&self.classifier_bias) {
                Ok(t) => t,
                Err(_) => return text.to_string(),
            },
            Err(_) => return text.to_string(),
        };

        let predictions = match logits.argmax(2) {
            Ok(t) => match t.squeeze(0) {
                Ok(t) => match t.to_vec1::<u32>() {
                    Ok(v) => v,
                    Err(_) => return text.to_string(),
                },
                Err(_) => return text.to_string(),
            },
            Err(_) => return text.to_string(),
        };

        let offsets = tokens.get_offsets();
        let mut redaction_mask = vec![false; text.len()];

        for (idx, &label_id) in predictions.iter().enumerate() {
            if let Some(label) = self.label_map.get(&label_id) {
                let label_upper = label.to_uppercase();
                if label_upper.contains("PER") || label_upper.contains("LOC") || label_upper.contains("ORG") {
                    if idx < offsets.len() {
                        let (start, end) = offsets[idx];
                        for i in start..end {
                            if i < redaction_mask.len() {
                                redaction_mask[i] = true;
                            }
                        }
                    }
                }
            }
        }

        let mut final_result = String::new();
        let mut redactions: Vec<(usize, usize)> = Vec::new();
        
        let mut start = None;
        for (i, &redact) in redaction_mask.iter().enumerate() {
            if redact && start.is_none() {
                start = Some(i);
            } else if !redact && start.is_some() {
                redactions.push((start.unwrap(), i));
                start = None;
            }
        }
        if let Some(s) = start {
            redactions.push((s, redaction_mask.len()));
        }

        if redactions.is_empty() {
            return text.to_string();
        }

        let mut merged = Vec::new();
        let (mut curr_s, mut curr_e) = redactions[0];
        for &(s, e) in &redactions[1..] {
            if s <= curr_e {
                curr_e = e;
            } else {
                merged.push((curr_s, curr_e));
                curr_s = s;
                curr_e = e;
            }
        }
        merged.push((curr_s, curr_e));

        let mut last_pos = 0;
        for (s, e) in merged {
            if s > last_pos {
                final_result.push_str(&text[last_pos..s]);
            }
            final_result.push_str("[REDACTED]");
            last_pos = e;
        }
        if last_pos < text.len() {
            final_result.push_str(&text[last_pos..]);
        }

        final_result
    }
}

pub fn init_scrubber() -> Result<SmartScrubber, Box<dyn std::error::Error>> {
    let device = Device::Cpu;
    let api = Api::new()?;
    let repo = api.repo(Repo::new("elastic/distilbert-base-cased-finetuned-conll03-english".to_string(), RepoType::Model));

    let config_file = repo.get("config.json")?;
    let tokenizer_file = repo.get("tokenizer.json")?;
    let weights_file = repo.get("model.safetensors")?;

    let config_content = std::fs::read_to_string(config_file)?;
    let ner_config: NerConfig = serde_json::from_str(&config_content)?;
    let tokenizer = Tokenizer::from_file(tokenizer_file).map_err(|e| e.to_string())?;

    let vb = unsafe {
        candle_nn::var_builder::VarBuilder::from_safetensors(vec![weights_file], candle_core::DType::F32, &device)?
    };

    let model = DistilBertModel::load(vb.pp("distilbert"), &ner_config.base)?;
    
    // Load classifier head
    let classifier_weights = vb.get((ner_config.num_labels, ner_config.base.dim), "classifier.weight")?;
    let classifier_bias = vb.get(ner_config.num_labels, "classifier.bias")?;

    let mut label_map = HashMap::new();
    for (id_str, label) in ner_config.id2label {
        if let Ok(id) = id_str.parse::<u32>() {
            label_map.insert(id, label);
        }
    }

    Ok(SmartScrubber {
        model,
        tokenizer,
        device,
        label_map,
        classifier_weights,
        classifier_bias,
    })
}

