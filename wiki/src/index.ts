/**
 * PUBLIC BARREL (DESIGN §10.7). The single public entry point of the `wiki`
 * package: re-exports the entry function, the public type surface, the authoring
 * helpers, the FSM guard helpers, the typed error hierarchy, and the Zod adapter.
 *
 * Internal-only machinery (CommandBus, EventLog, Registry, the structure/render
 * modules) is deliberately NOT re-exported — those are implementation details
 * behind the interfaces in `./api`.
 */

// ── entry point ───────────────────────────────────────────────────────────────
export { createWiki } from "./core/wiki";

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
  // event sourcing
  IEventMeta,
  IEventEnvelope,
  DomainEvent,
  // workspace aggregate state
  WorkspaceStatus,
  IItemRecord,
  IPageNode,
  IWorkspaceState,
  PageState,
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
  ICommandDef,
  CommandMap,
  IPageTypeDef,
  IItemTypeDef,
  IPageType,
  IItemType,
} from "./api";

// ── authoring helpers ─────────────────────────────────────────────────────────
export { definePageType, defineItemType } from "./core/define";

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
} from "./core/errors";
export type { SchemaIssue } from "./core/errors";

// ── Zod schema adapter ────────────────────────────────────────────────────────
export { zodSchema, z } from "./schema/zod-adapter";
