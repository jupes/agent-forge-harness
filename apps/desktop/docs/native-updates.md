# Native signed update engineering

The closed metadata protocol and client model separate checking, downloading,
reviewing and explicitly confirming installation. An install intent is saved
and read back before protected audit authorization and one native request.
A lost reply retains that exact identity across reload and permits read-only
outcome recovery; it never resends installation automatically.

The foundation is tested with inert native/audit/storage stand-ins. It is not
yet mounted in Settings. The native producer and pinned dependency proposal
remain in progress; no actual update package or installer has been run.

The required producer uses the official Tauri updater, a publisher public key
fixed at build time and a fixed official release channel. A build without a
release key must report unconfigured and refuse update network/install work.
The renderer cannot choose a URL, key, file, command or installer argument.

Engineering integration, publisher signing/channel setup, packaged installation
and actual Windows manual acceptance remain required for full 1.0.
