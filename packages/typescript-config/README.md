# @repo/typescript-config

Shared TypeScript configurations for the QR ControlNet monorepo.

## Available Configurations

### `base.json` - Foundation Configuration

Base TypeScript configuration with strict settings and modern features.

```json
{
  "extends": "@repo/typescript-config/base.json"
}
```

### `node.json` - Node.js Applications

Optimized for Node.js applications like your API server.

```json
{
  "extends": "@repo/typescript-config/node.json"
}
```

### `react.json` - React Applications

Configured for React/Next.js applications with JSX support.

```json
{
  "extends": "@repo/typescript-config/react.json"
}
```

### `library.json` - Library Packages

Optimized for library packages with proper declaration generation.

```json
{
  "extends": "@repo/typescript-config/library.json"
}
```

## Usage Examples

### API Application (Node.js)

```json
{
  "extends": "@repo/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Client Application (React/Next.js)

```json
{
  "extends": "@repo/typescript-config/react.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@/components/*": ["./src/components/*"]
    }
  }
}
```

### Shared Package (Library)

```json
{
  "extends": "@repo/typescript-config/library.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

## Features

- ✅ **Strict TypeScript** - Maximum type safety
- ✅ **Modern ES2022** - Latest JavaScript features
- ✅ **Source Maps** - Better debugging experience
- ✅ **Declaration Files** - Proper .d.ts generation
- ✅ **Path Mapping** - Clean import paths
- ✅ **Incremental Builds** - Faster compilation
- ✅ **Tree Shaking** - Optimized for bundlers

## Configuration Details

### Base Settings

- Target: ES2022
- Module: NodeNext
- Strict: true
- Source maps: enabled
- Declaration files: enabled

### Node.js Specific

- CommonJS modules
- Node.js types included
- Path mapping support

### React Specific

- JSX: react-jsx
- DOM types included
- Bundler module resolution
- No emit (handled by bundler)

### Library Specific

- ESNext modules
- Declaration generation
- Tree-shaking optimized
- Preserved modules

## Extending Configurations

You can extend any configuration and override specific options:

```json
{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "target": "ES2021",
    "outDir": "./build",
    "baseUrl": ".",
    "paths": {
      "@utils/*": ["./src/utils/*"]
    }
  },
  "include": ["custom-src/**/*"]
}
```
