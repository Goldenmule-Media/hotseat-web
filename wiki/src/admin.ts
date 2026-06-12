/**
 * Public **admin / operational API** (subpath `wiki/admin`).
 *
 * Operator-facing engine operations that act ON a workspace's STORAGE — moving,
 * copying, or otherwise administering streams — rather than authoring a workspace's
 * content. They live on a dedicated subpath so they read as (and are fenced off as)
 * operator tooling, distinct from the everyday authoring/read API on the main `wiki`
 * barrel. They are not part of `IWiki`/`IWorkspaceHandle`: an app embeds the engine
 * for content; an operator reaches for these.
 *
 * Today this is stream-to-stream workspace REPLICATION — copy a workspace's whole
 * event stream between Durable Streams servers (e.g. local↔remote migration). Future
 * operational ops (clone-to-a-new-id, export/import, bulk re-projection) belong here
 * too. The engine's other admin-flavored actions are deliberately `IWorkspaceHandle`
 * methods (`assignSerials`, `archive`/`unarchive`, `rename`) and stay there.
 */
export { replicateWorkspace, ReplicationConflictError } from "./core/replicate";
export type { ReplicateWorkspaceOptions, ReplicationReport } from "./core/replicate";
