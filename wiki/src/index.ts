/**
 * PUBLIC BARREL (DESIGN §10.7). The single public entry point of the `wiki`
 * package: re-exports the entry function, the public type surface, the authoring
 * helpers, the FSM guard helpers, the typed error hierarchy, and the Zod adapter.
 *
 * Internal-only machinery (CommandBus, EventLog, the structure/render modules) is
 * deliberately NOT re-exported here — those are implementation details behind the
 * interfaces in `./api`. The `Registry` is the one exception: not in this barrel, but
 * exposed via the `wiki/registry` subpath so an external read model can build one and
 * reuse the public `foldWorkspace` (DESIGN §8.6).
 */

// ── entry point ───────────────────────────────────────────────────────────────
export { createWiki } from "./core/wiki";

// ── public, pure fold (for external read models — DESIGN §8.6, §16.1) ──────────
export { foldWorkspace, applyWorkspace } from "./core/workspace";

// ── consistency-token codec (the §8.6 token SHAPE; for external read models) ───
// An external IReadModel (e.g. wiki-mcp's SQL projection) must encode/decode the
// SAME opaque `{ workspaceId, version }` token the engine's writes return, so the
// codec is part of the public surface alongside the token type.
export { encodeToken, decodeToken, ZERO_VERSION } from "./core/readmodel";

// ── public runtime values from the type surface ──────────────────────────────
export { ROOT } from "./api";

// ── public type surface (types only) ─────────────────────────────────────────
export type {
  // branded ids & sentinels
  WorkspaceId,
  PageId,
  RootId,
  // generic helpers
  JsonSchema,
  DeepReadonly,
  Unsubscribe,
  // CQRS consistency tokens & read model (§8.6)
  ConsistencyToken,
  Committed,
  IReadOpts,
  IReadModel,
  // event sourcing
  IEventMeta,
  IEventEnvelope,
  DomainEvent,
  // workspace aggregate state
  WorkspaceStatus,
  IPageNode,
  IWorkspaceState,
  PageState,
  // content tree (§2, §3)
  SectionId,
  BlockId,
  ISection,
  IField,
  FieldKind,
  RefTarget,
  IItem,
  IBlock,
  IInline,
  Mark,
  SectionOp,
  SectionOpsAppliedPayload,
  TextEdit,
  // entry point & configuration
  IStreamConfig,
  IWikiConfig,
  // IWiki
  IWorkspaceSummary,
  IWiki,
  // type-level helpers
  PageTypeName,
  StatusOf,
  CommandName,
  CommandArgs,
  CommandResult,
  CreateArgs,
  // IWorkspaceHandle
  ITreeNode,
  IWorkspaceHandle,
  // IPageView
  IMutationDescriptor,
  IPageView,
  // FSM transition
  ITransition,
  // authoring API
  ISchema,
  ICommandContext,
  IRelatedReader,
  IRenderCtx,
  FieldDecl,
  SectionDecl,
  ElementDecl,
  SectionSetContract,
  ArgRef,
  FieldValueSpec,
  Precondition,
  DeclarativeCommand,
  DeclarativeCommandMap,
  RenderConfig,
  SectionRender,
  IPageTypeDef,
  IPageType,
} from "./api";

// ── authoring helpers ─────────────────────────────────────────────────────────
export { definePageType, arg } from "./core/define";

// ── FSM guard helpers ─────────────────────────────────────────────────────────
export { t, makeGuard, renderMermaid } from "./core/guard";
export type { Guard } from "./core/guard";

// ── typed error hierarchy ─────────────────────────────────────────────────────
export {
  WikiError,
  ValidationError,
  MutationNotAllowedError,
  WorkspaceNotFoundError,
  WorkspaceArchivedError,
  PageNotFoundError,
  ItemNotFoundError,
  ParentNotFoundError,
  CycleError,
  DuplicateTitleError,
  LinkTargetNotFoundError,
  ConcurrencyError,
  InvariantViolationError,
  UnknownPageTypeError,
  ConsistencyTimeoutError,
  SectionNotFoundError,
  DuplicateSectionKeyError,
  SectionContractError,
  FieldKindError,
  RefIntegrityError,
  BlockNormalFormError,
  PreconditionUnmetError,
  StaleEditError,
} from "./core/errors";
export type { SchemaIssue } from "./core/errors";

// ── Zod schema adapter ────────────────────────────────────────────────────────
export { zodSchema, z } from "./schema/zod-adapter";
