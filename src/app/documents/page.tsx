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
  // Resolve identity on the server (there is no client SessionProvider) and hand it down. The list
  // needs it to know which action a row gets: an owner deletes, everyone else leaves — and "leave"
  // is a DELETE on *your own* collaborator row, so it needs your id.
  const session = await auth();
  const currentUserId = session?.user?.id ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">Documents</h1>
      <DocumentList currentUserId={currentUserId} />
    </div>
  );
}
