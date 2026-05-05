FROM rust:latest AS builder

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    pkg-config libssl-dev libc6-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# FEATURES="" → lite/standard (regex only, ~8 MB binary, instant start)
# FEATURES="ner" → full (DistilBERT NER, ~80 MB binary)
ARG FEATURES=""
RUN if [ -n "$FEATURES" ]; then \
      cargo build --release --features "$FEATURES"; \
    else \
      cargo build --release; \
    fi

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    libssl3 ca-certificates curl fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /usr/src/app/target/release/ocr_memory_rust .

# Pre-bake NER model into the image at build time (full mode only).
# The binary downloads the model during PREBAKE_ONLY=1 then exits.
# At runtime the model is already on disk — zero download delay.
ARG FEATURES=""
ENV HF_HOME=/model_cache
RUN if [ "$FEATURES" = "ner" ]; then PREBAKE_ONLY=1 ./ocr_memory_rust; fi

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=30s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["ocr_memory_rust"]
