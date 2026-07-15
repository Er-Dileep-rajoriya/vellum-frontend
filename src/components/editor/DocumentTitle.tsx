"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TokenProvider } from "@/services/transport";

/**
 * The editable document title, in the editor header.
 *
 * Behaves like a modern doc: the title *is* the heading, not a field next to one. You click it, type,
 * and it saves — on Enter or on blur, whichever comes first. There is no Save button, because a title
 * nobody remembers to save is a title that silently stays "Untitled".
 *
 * Persistence is a plain `PATCH /documents/:id` (the backend already owns rename + authorization). The
 * write is optimistic: the new text stays on screen immediately and only reverts if the server refuses
 * — a rename is low-stakes and the round trip should never make the cursor wait.
 *
 * A VIEWER cannot rename (the backend enforces it; we mirror that here by rendering plain text), so
 * the control never dangles an edit affordance the server would reject.
 */
export function DocumentTitle({
  documentId,
  apiUrl,
  getToken,
}: {
  readonly documentId: string;
  readonly apiUrl: string;
  readonly getToken: TokenProvider;
}) {
  const [title, setTitle] = useState("Untitled");
  const [canEdit, setCanEdit] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // The last value the server has confirmed. A failed save reverts to this, and it is the baseline we
  // diff against so an unchanged blur does not fire a pointless request.
  const savedRef = useRef("Untitled");

  useEffect(() => {
    let ignore = false;

    void (async () => {
      try {
        const token = await getToken();
        const response = await fetch(`${apiUrl}/api/documents/${documentId}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!response.ok) return;

        const body = (await response.json()) as {
          document: { title: string; role: "OWNER" | "EDITOR" | "VIEWER" };
        };
        if (ignore) return;

        setTitle(body.document.title);
        savedRef.current = body.document.title;
        setCanEdit(body.document.role !== "VIEWER");
        setLoaded(true);
      } catch {
        // Leave the placeholder. The editor still works; only the label is unknown, and that is not
        // worth an error banner over the writing surface.
      }
    })();

    return () => {
      ignore = true;
    };
  }, [documentId, apiUrl, getToken]);

  const save = useCallback(
    async (raw: string) => {
      // An empty title is not a title. Fall back to "Untitled" rather than letting the backend's
      // min-length rule reject the write and strand the user on an un-saveable field.
      const next = raw.trim() === "" ? "Untitled" : raw.trim();

      if (next === savedRef.current) {
        setTitle(next); // normalise whitespace even when nothing changed
        return;
      }

      setTitle(next);
      setSaving(true);
      try {
        const token = await getToken();
        const response = await fetch(`${apiUrl}/api/documents/${documentId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: next }),
        });
        if (!response.ok) throw new Error("rename failed");

        savedRef.current = next;
      } catch {
        // Revert to the last server-confirmed value. Silent by design: the old title is still correct,
        // so there is nothing the user must act on.
        setTitle(savedRef.current);
      } finally {
        setSaving(false);
      }
    },
    [documentId, apiUrl, getToken],
  );

  if (!canEdit) {
    return (
      <h1
        className={`text-3xl font-bold tracking-tight sm:text-4xl ${loaded ? "" : "animate-pulse text-muted-foreground"}`}
      >
        {title}
      </h1>
    );
  }

  return (
    <input
      aria-label="Document title"
      value={title}
      disabled={saving}
      onChange={(event) => setTitle(event.target.value)}
      onBlur={(event) => void save(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          // Blur commits through onBlur — one save path, not two.
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setTitle(savedRef.current);
          event.currentTarget.blur();
        }
      }}
      maxLength={200}
      spellCheck={false}
      placeholder="Untitled"
      // The page heading, edited in place: no visible box until you interact, then a soft focus ring.
      // A doc title should read as a title, not a form field.
      className="-ml-2 w-full rounded-lg bg-transparent px-2 py-1 text-3xl font-bold tracking-tight outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-accent/50 focus:bg-accent/40 focus:ring-2 focus:ring-foreground/15 sm:text-4xl"
    />
  );
}
