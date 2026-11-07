#!/bin/bash
bun build index.ts --outfile actor-opencode --compile && cp actor-opencode ~/bin
