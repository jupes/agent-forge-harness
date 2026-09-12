/**
 * Copy-to-clipboard with a toast, delegated from a container.
 *
 * Extracted from the old `app.mjs` so every document gets the same behavior:
 * the toast element is rendered by `AppShell`, and any `.issue-id-copy` button
 * anywhere inside the container copies its `data-copy-text`.
 */

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showCopyToast(message: string): void {
  const el = document.getElementById("copy-toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    el.textContent = "";
    toastTimer = null;
  }, 2600);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path — clipboard access is blocked in
    // insecure contexts and by some permission policies.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Delegate clicks on `.issue-id-copy` inside `container`.
 * Returns a teardown function.
 */
export function installCopyDelegation(container: HTMLElement): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.(".issue-id-copy");
    if (!button || !container.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = button.getAttribute("data-copy-text");
    if (!text) return;
    void copyText(text).then((ok) => {
      showCopyToast(
        ok
          ? `Copied: ${text}`
          : "Could not copy — try selecting the ID manually.",
      );
    });
  };

  container.addEventListener("click", onClick);
  return () => container.removeEventListener("click", onClick);
}
