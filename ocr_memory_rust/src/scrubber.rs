use regex::Regex;

// ── NER-specific imports (only compiled with --features ner) ─────────────────
#[cfg(feature = "ner")]
use candle_core::{Device, Tensor};
#[cfg(feature = "ner")]
use candle_transformers::models::distilbert::{Config, DistilBertModel};
#[cfg(feature = "ner")]
use hf_hub::{api::sync::Api, Repo, RepoType};
#[cfg(feature = "ner")]
use tokenizers::Tokenizer;
#[cfg(feature = "ner")]
use std::collections::HashMap;
#[cfg(feature = "ner")]
use serde::Deserialize;

#[cfg(feature = "ner")]
#[derive(Deserialize, Debug)]
struct NerConfig {
    #[serde(flatten)]
    base: Config,
    num_labels: usize,
    id2label: HashMap<String, String>,
}

// ── Scrubber struct ───────────────────────────────────────────────────────────
// Without `ner` feature: zero-size struct, regex-only scrubbing.
// With `ner` feature: holds the DistilBERT model for entity detection.

pub struct SmartScrubber {
    #[cfg(feature = "ner")]
    model: DistilBertModel,
    #[cfg(feature = "ner")]
    tokenizer: Tokenizer,
    #[cfg(feature = "ner")]
    device: Device,
    #[cfg(feature = "ner")]
    label_map: HashMap<u32, String>,
    #[cfg(feature = "ner")]
    classifier_weights: Tensor,
    #[cfg(feature = "ner")]
    classifier_bias: Tensor,
}

impl SmartScrubber {
    pub fn scrub(&self, text: &str) -> String {
        let result = regex_pass(text);
        #[cfg(feature = "ner")]
        let result = self.smart_pass(&result);
        result
    }

    #[cfg(feature = "ner")]
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

        let attention_mask = match input_ids_tensor.ones_like() {
            Ok(t) => t,
            Err(_) => return text.to_string(),
        };

        let output = match self.model.forward(&input_ids_tensor, &attention_mask) {
            Ok(t) => t,
            Err(_) => return text.to_string(),
        };

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
                let upper = label.to_uppercase();
                if upper.contains("PER") || upper.contains("LOC") || upper.contains("ORG") {
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

        build_redacted(text, &redaction_mask)
    }
}

fn regex_pass(text: &str) -> String {
    let email  = Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap();
    let ip     = Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap();
    let secret = Regex::new(r"sk-[a-zA-Z0-9]{32,}").unwrap();
    let mut r  = text.to_string();
    r = email.replace_all(&r, "[REDACTED]").to_string();
    r = ip.replace_all(&r, "[REDACTED]").to_string();
    r = secret.replace_all(&r, "[REDACTED]").to_string();
    r
}

#[cfg(feature = "ner")]
fn build_redacted(text: &str, mask: &[bool]) -> String {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, &redact) in mask.iter().enumerate() {
        if redact && start.is_none() { start = Some(i); }
        else if !redact && start.is_some() { ranges.push((start.unwrap(), i)); start = None; }
    }
    if let Some(s) = start { ranges.push((s, mask.len())); }

    let mut merged: Vec<(usize, usize)> = Vec::new();
    if let Some(&(mut cs, mut ce)) = ranges.first() {
        for &(s, e) in &ranges[1..] {
            if s <= ce { ce = e; } else { merged.push((cs, ce)); cs = s; ce = e; }
        }
        merged.push((cs, ce));
    }

    let mut result = String::new();
    let mut last = 0;
    for (s, e) in merged {
        if s > last { result.push_str(&text[last..s]); }
        result.push_str("[REDACTED]");
        last = e;
    }
    if last < text.len() { result.push_str(&text[last..]); }
    result
}

// ── Init ──────────────────────────────────────────────────────────────────────

pub fn init_scrubber() -> Result<SmartScrubber, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(feature = "ner")]
    return init_ner();

    #[cfg(not(feature = "ner"))]
    Ok(SmartScrubber {})
}

#[cfg(feature = "ner")]
fn init_ner() -> Result<SmartScrubber, Box<dyn std::error::Error + Send + Sync>> {
    let device = Device::Cpu;
    let api = Api::new()?;
    let repo = api.repo(Repo::new(
        "elastic/distilbert-base-cased-finetuned-conll03-english".to_string(),
        RepoType::Model,
    ));

    let config_file    = repo.get("config.json")?;
    let tokenizer_file = repo.get("tokenizer.json")?;
    let weights_file   = repo.get("model.safetensors")?;

    let ner_config: NerConfig = serde_json::from_str(&std::fs::read_to_string(config_file)?)?;
    let tokenizer = Tokenizer::from_file(tokenizer_file).map_err(|e| e.to_string())?;

    let vb = unsafe {
        candle_nn::var_builder::VarBuilder::from_safetensors(
            vec![weights_file],
            candle_core::DType::F32,
            &device,
        )?
    };

    let model              = DistilBertModel::load(vb.pp("distilbert"), &ner_config.base)?;
    let classifier_weights = vb.get((ner_config.num_labels, ner_config.base.dim), "classifier.weight")?;
    let classifier_bias    = vb.get(ner_config.num_labels, "classifier.bias")?;

    let mut label_map = HashMap::new();
    for (id_str, label) in ner_config.id2label {
        if let Ok(id) = id_str.parse::<u32>() {
            label_map.insert(id, label);
        }
    }

    Ok(SmartScrubber { model, tokenizer, device, label_map, classifier_weights, classifier_bias })
}
