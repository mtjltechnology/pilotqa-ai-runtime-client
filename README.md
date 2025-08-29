# PilotQA AI Runtime

Client-only runtime of PilotQA AI for Playwright. This repo excludes internal tools.

## Configure

- Copy `.env.example` to `.env` and set your variables.
- Provide `PILOTQA_AUTH_TOKEN` and either `TOKEN_PUBLIC_KEY_PATH`, `TOKEN_PUBLIC_KEY` or `TOKEN_SERVICE_URL`.

## Usage (Playwright)

import { PilotQA_AI } from './PilotQA_AI/pilotqa-ai';
