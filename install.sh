#!/usr/bin/env bash

echo "🚀 Installing Agentic Blueprints..."

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
