# Forge links

The desktop accepts three navigation addresses:

- agent-forge://project/<project-id>
- agent-forge://bead/<bead-id>
- agent-forge://session/<session-id>

Encode the identifier as one URI segment. Identifiers are decoded once. Extra segments, queries, fragments, malformed escapes and control characters are refused. A link never starts work, grants access, changes a project, or carries an operator token.

The main window keeps the latest requested destination while connecting. It checks the connected hearth's project catalog, reads the relevant protected scoped metadata, and rechecks catalog revision and scope before opening the item. Missing, archived, ambiguous and unavailable sources offer recovery in Projects. Failed verification requires an explicit retry. Other workspaces remain unavailable from this hearth.

Session addresses use the existing session-observation ownership projection, including ordinary, managed and observed sessions. They open the existing appropriate session view. No private transcript is read to find the owning project. Duplicate project ownership requires the user to choose a project.

Opening a newer link, navigating manually, dismissing recovery, losing the connection or closing the window fences older reads. Metadata reads use at most four concurrent requests, a 15-second request deadline and a 20-second activation deadline. Native delivery retains the latest request for startup/reload recovery. Only the consumed process generation and sequence are stored in sessionStorage; the URI is not persisted there.

Renderer integration uses the fixed version1 data envelope and main-window event. Popped-out sessions do not consume product links. The envelope grants no additional native command or provider authority.

## Qualification

Pure parser, scope and activation tests and protected-reader tests are retained. Hosted browser evidence must cover cold delivery, warm activation, all three object types, invalid/missing/archived/ambiguous targets, delayed scope changes and zero mutation requests. Browser fixtures do not qualify native Windows protocol registration or delivery.

Native delivery source uses pinned Tauri single-instance and deep-link plugins. The primary process owns the latest bounded request; secondary launches forward their original URI spelling and focus that main window before any checkout picker or Hearth startup. The main window checks its current host origin before delivering the fixed navigation envelope.

The installer declares the agent-forge scheme; the portable folder does not register a Windows association. Actual installed protocol association, cold/warm Windows focus/lifecycle evidence and manual keyboard/Light acceptance remain pending until separately recorded. Earlier native runs retain their original holds; source integration does not close the 1.0 deep-link task.

References: [Tauri deep links](https://v2.tauri.app/plugin/deep-linking/), [single instance](https://v2.tauri.app/plugin/single-instance/).
