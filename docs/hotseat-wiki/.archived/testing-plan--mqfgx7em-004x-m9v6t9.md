# Testing plan — Model page: show page schema and current-state mutable sections

**Status:** ready

## Planned
_None._

## Passed
- buildSchemaModel: a section with mutableIn:["draft","planning","building"] (feature-brief) has mutableNow=true when currentStatus='draft' and mutableNow=false when currentStatus='shipped'.
- buildSchemaModel: a section with NO mutableIn declared yields mutableNow=true for ANY currentStatus, and mutableIn=null (the always-mutable default).
- buildSchemaModel: each FieldDecl kind maps to the correct row kind across the closed set (scalar, prose, code, attachment-ref, ref, blocks, list, serial).
- buildSchemaModel: a list field surfaces elementType (and ordered); a ref field surfaces targetKinds.
- buildSchemaModel: requiredInCurrent is true exactly when a field's requiredIn includes currentStatus (using a bundle field that declares requiredIn).
- buildSchemaModel: nested SectionDecl.sections are recursed into subsections (using the architecture bundle, which declares nested sections).
- defOf returns the IPageTypeDef for a known bundled type (e.g. 'feature-brief') and null for an unknown/undefined type, synchronously with no worker connection.
- Manual/build verification: in the Model view, when def!==null and fsm!==null both FsmGraph and SchemaInspector render; the schema panel shows mutable vs locked sections for the page's current status. `npm run typecheck`, `npm run test`, and `npm run build` pass from inside wiki-ui/ with no worker/handshake/wiki-host-api.ts changes.
- buildSchemaModel: every FieldKind has a non-empty FIELD_KIND_HINT, and each field row carries its kind's hint.
- buildSchemaModel: a list field resolves its element type against def.elements to the element's own fields; an element with a status FSM surfaces its lifecycle states.
- buildSchemaModel: an unknown or self-referential element type leaves element=null (no infinite recursion). The type token renders list<element> / ref<targets> and the kind meaning is exposed on hover.

## Failed
_None._

## References
_None._

## Child pages
_None._
