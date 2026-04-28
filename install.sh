#!/usr/bin/env bash

echo "🚀 Installing Agentic Blueprints..."

# Check for code-review-graph
if ! command -v code-review-graph &> /dev/null; then
    echo "📥 Installing code-review-graph..."
    pip install code-review-graph || echo "❌ Failed to install code-review-graph automatically. Please run: pip install code-review-graph"
else
    echo "✅ code-review-graph is already installed."
fi

# Ensure .gemini/skills exists
mkdir -p .gemini/skills

# Copy skills (assuming script runs from repo root)
cp -r skills/* .gemini/skills/
echo "✅ Skills injected into .gemini/skills/"

# Scaffold CONTEXT.md if it doesn't exist
if [ ! -f CONTEXT.md ]; then
  cat <<EOF > CONTEXT.md
# Project Context

## Purpose
[Describe why this project exists]

## Tech Stack
[Languages, Frameworks, DBs]

## Domain Language
[Key terms and their definitions]
EOF
  echo "✅ Created starter CONTEXT.md"
fi

# Setup local memory
mkdir -p .memory
if [ ! -f .memory/INDEX.md ]; then
  echo "# Knowledge Graph Index\n\n[[Decisions]]\n[[Lessons-Learned]]" > .memory/INDEX.md
  echo "✅ Initialized local Memory Vault at .memory/"
fi

echo -e "\n🎉 Setup Complete! Try: 'Gemini, activate the Architect skill.'"
