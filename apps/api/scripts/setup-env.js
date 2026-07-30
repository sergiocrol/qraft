#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function setupEnvironmentFiles() {
  const envFiles = [
    {
      example: ".env.example",
      target: ".env",
      description: "Development environment",
    },
    {
      example: ".env.example",
      target: ".env.production",
      description: "Production environment template",
    },
  ];

  console.log("🔧 Setting up API environment files...\n");

  envFiles.forEach(({ example, target, description }) => {
    const examplePath = path.join(__dirname, "..", example);
    const targetPath = path.join(__dirname, "..", target);

    if (!fs.existsSync(examplePath)) {
      console.log(`❌ ${example} not found, skipping ${target}`);
      return;
    }

    if (fs.existsSync(targetPath)) {
      console.log(`ℹ️  ${target} already exists - ${description}`);
      return;
    }

    fs.copyFileSync(examplePath, targetPath);
    console.log(`✅ Created ${target} - ${description}`);
  });
}

if (require.main === module) {
  setupEnvironmentFiles();
}

module.exports = { setupEnvironmentFiles };
