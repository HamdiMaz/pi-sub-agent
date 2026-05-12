# pi-sub-agent

A Pi package extension that will provide sub-agent functionality.

## Status

This repository is currently scaffolded for Pi extension development only. It does not implement sub-agent behavior yet.

## Development

Install dependencies:

```bash
npm install
```

Run verification:

```bash
npm run typecheck
npm run lint
npm run check
```

## Loading locally in Pi

For quick extension testing:

```bash
pi -e ./extensions/index.ts
```

As a local Pi package:

```bash
pi install ./ -l
```

The package manifest exposes `./extensions` through the `pi.extensions` field.
