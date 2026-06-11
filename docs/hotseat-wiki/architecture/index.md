# Architecture

**Status:** active

## Overview
Architecture map of the **hotseat-web** monorepo — an event-sourced, CQRS, LLM-first structured wiki. Each page below is a typed `architecture` node documenting one unit of the system; the **Dependencies** edges between nodes form the real import graph. Four nodes are the npm-workspace packages — strictly layered so dependency arrows point downward, the import boundaries load-bearing and not to be crossed — and **wiki-ui** is a standalone Next.js browser app (not a workspace member) that embeds the engine client-side. Product/feature documents live under the **Feature Specs** TOC.

## Contents
- **Engine & schema** — The transport-free engine and the runtime-loaded page-type schema it executes.
  - [wiki](architecture:mpznj2kb-0009-pvqw9d)
  - [wiki-models](architecture:mpznj3vk-000b-mqwd0h)
- **Host & process** — The long-lived MCP + read-model host and the process that wires it to durable storage.
  - [wiki-mcp](architecture:mpznj4z6-000d-dzkr85)
  - [wiki-server](architecture:mpznj67y-000f-mrah2o)
- **Clients** — Consumers that live outside the package layering — they embed the engine directly rather than importing a host.
  - [wiki-ui](architecture:mq6p8be5-001t-rjcytt)
- **Ungrouped**
  - [Content model](architecture:mq5nej50-0026-edazv6)
  - [wiki-mirror](architecture:mqa0p1qp-00po-bgsbah)
