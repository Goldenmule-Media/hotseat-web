# Decision Records

**Status:** active

## Overview
_No overview yet._

## Contents
- [Design decisions live in the wiki](decision-record:mq110m3o-0003-gqol23)
- [Use Durable Streams directly; no storage port](decision-record:mq110mit-000h-uiaeta)
- [Workspace as the aggregate (one stream)](decision-record:mq110mwg-000s-qskj9e)
- [CQRS with consistency tokens](decision-record:mq110nbn-0015-3ca3bj)
- [Sections are the one content container](decision-record:mq110nu1-001m-bxhtz)
- [Closed field-kinds, including the `blocks` document model](decision-record:mq110o7q-001x-s18c8w)
- [Generic section operations + one engine-owned reducer (no per-type events/reducers/renderers)](decision-record:mq110ong-002a-q0qu0c)
- [Render as a configurable read model](decision-record:mq110p13-002l-9s15k0)
- [`ref` as a field-kind (render-derived cross-reference)](decision-record:mq110pes-002w-24h819)
- [The section tree is author-editable, with model-declared constraints](decision-record:mq110psq-0037-r8ync2)
- [Greenfield: no backward compatibility](decision-record:mq110q71-003i-l972gi)
- [Page archival is an orthogonal visibility flag, not a status](decision-record:mq110qlm-003t-8cls2q)
- [CQRS with consistency tokens in the engine core](decision-record:mq110r0h-0044-8hd26x)
- [SQL read model via Kysely; PGlite local, pg prod](decision-record:mq110reh-004f-xcble1)
- [Projection = engine-fold + serialize-to-SQL](decision-record:mq110rsx-004r-e4dtrk)
- [The MCP server manages tokens for automatic read-your-writes](decision-record:mq110s7c-0053-4ogxbm)
- [wiki-mcp holds the logic; wiki-server hosts it](decision-record:mq110slv-005f-qjht2l)
- [Live ModelRegistry with cache-busted hot-reload](decision-record:mq110t2n-005s-7ygyqn)
- [AST/analysis as read-side projections + a runtime LanguageRegistry](decision-record:mq110tnc-0069-st531h)
- [Host streams; do not wrap the engine](decision-record:mq110u5y-006o-qf3uxh)
- [Wrap the Node server for the self-host tier](decision-record:mq110ukx-006z-3ls7bz)
- [wiki-server hosts wiki-mcp](decision-record:mq110v2c-007c-hjq73f)
- [Upcast-to-latest with self-contained version history](decision-record:mq110vib-007n-d51lny)
- [Declarative page types: the engine owns the reducer, render, and events; models declare structure + render config + contracts](decision-record:mq110w00-0080-159l52)
- [Embed the engine; spawn the server; import neither's internals](decision-record:mq110wi4-008d-nmz3cj)
- [Admin "by degrees" via command locality](decision-record:mq110wxm-008o-jd7u2c)
- [Logs via the control API, not Durable Streams](decision-record:mq110xdu-008z-utyvhf)
- [Remote auth via an engine `IStreamConfig.headers` hook](decision-record:mq110xwb-009c-h64sj5)
- [Generic mutations in v1, generated subcommands later](decision-record:mq110ye5-009p-4evl6w)
- [Cross-workspace operations are an admin/system affordance, not a content read](decision-record:mq5hnpu9-001m-c9yfrl)
- [Declared authored-ness gates (`requiredIn`): the engine enforces field completeness per status](decision-record:mq9oa2cx-0014-scc7q)
- [Markdown emission is a local stream-client, not a host responsibility](decision-record:mqa1x5yj-000d-foj09k)
- [GitHub auth at the host edge: an auth gateway + per-surface injected enforcement](decision-record:mqazxkh2-0001-vnogwy)
- [OAuth 2.1 façade over the stateless gateway — signed-blob codes and refresh tokens](decision-record:mqbdi1vx-00en-9zdj8q)
