import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "plenty_session";

/** App areas that need a signed-in user. The pages themselves re-validate the session. */
const PROTECTED = [
  "/home",
  "/kitchen",
  "/receipts",
  "/list",
  "/meals",
  "/insights",
  "/settings",
  "/notifications",
  "/search",
  "/onboarding",
];

/**
 * Optimistic auth gate: bounce requests without a session cookie to sign-in
 * before rendering anything. Authoritative checks happen server-side.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isProtected && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon|demo/|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)"],
};
