import { auth } from "@/auth";
import { DocumentList } from "@/components/documents/DocumentList";

/**
 * The document list.
 *
 * A Server Component that renders the shell and a client island that fetches. It deliberately does
 * NOT fetch the list on the server: the backend needs a bearer token minted from the session, and
 * doing that round trip here would block the first paint on two sequential network calls (session →
 * token → list) before anything appears.
 *
 * The list is server *data* — unlike a document, which lives on the device — so it genuinely does
 * require the network. But the shell, the header, and the skeleton do not, and they should be on
 * screen instantly.
 */
export default async function DocumentsPage() {
  const session = await auth();

  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl px-6 py-12">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as {session?.user?.email ?? "—"}
          </p>
        </div>
      </header>

      <DocumentList />
    </div>
  );
}
