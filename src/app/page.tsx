import Link from "next/link";
import { ArrowRight, CloudOff, GitBranch, Users } from "lucide-react";

/**
 * The landing page — a Server Component.
 *
 * Zero JavaScript ships for this route. The editor is a client island loaded only when a document is
 * opened. That split is the entire point of the App Router: the marketing page paints instantly on a
 * slow connection while a Notion-class editor sits one navigation away.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex flex-1 max-w-4xl flex-col justify-center px-6 py-20">
      <p className="mb-4 text-sm font-medium text-muted-foreground">Vellum</p>

      <h1 className="max-w-2xl text-balance text-5xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
        A document editor that doesn&apos;t need the internet.
      </h1>

      <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
        Every keystroke is saved locally first and synced in the background. Write on a plane, land, and
        watch your work merge with your team&apos;s — without losing a single character.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/documents/demo"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open the demo document
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>

      <dl className="mt-20 grid gap-8 sm:grid-cols-3">
        <Feature
          icon={<CloudOff className="size-5" aria-hidden />}
          title="Local-first"
          body="The editor never waits for a server. IndexedDB is the source of truth; the network is an optimisation."
        />
        <Feature
          icon={<Users className="size-5" aria-hidden />}
          title="Conflict-free"
          body="A sequence CRDT merges concurrent edits deterministically. No last-write-wins, so nobody's paragraph disappears."
        />
        <Feature
          icon={<GitBranch className="size-5" aria-hidden />}
          title="Immutable history"
          body="Restoring a version appends new operations rather than rewriting the past. History is append-only, enforced by the database."
        />
      </dl>
    </main>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm font-medium">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </dt>
      <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</dd>
    </div>
  );
}
