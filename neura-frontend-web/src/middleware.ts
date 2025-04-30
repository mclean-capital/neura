import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  // Get the path of the request
  const path = request.nextUrl.pathname;

  // // Add a debug param to break the loop if needed
  // const url = request.nextUrl.clone();
  // const debug = url.searchParams.get("debug");

  // // If debug mode is enabled, skip all redirects
  // if (debug === "true") {
  //   console.log("[Middleware] Debug mode enabled, skipping redirects");
  //   return NextResponse.next();
  // }

  // Define paths that are publicly accessible
  const isPublicPath = path === "/login" || path.startsWith("/api/");

  // // TEMPORARY: Always allow access to all paths to break redirect loop
  // console.log("[Middleware] Path:", path);
  return NextResponse.next();

  // // Check if token exists in cookies
  // const token = request.cookies.get("authToken")?.value;
  // console.log(
  //   "[Middleware] Token from cookies:",
  //   token ? "exists" : "not found"
  // );

  // // If path is not public and no token exists, redirect to login
  // if (!isPublicPath && !token) {
  //   console.log("[Middleware] Redirecting to login");
  //   return NextResponse.redirect(new URL("/login", request.url));
  // }

  // // If user is on login path but has a token, redirect to the home page
  // if (isPublicPath && token && path === "/login") {
  //   console.log("[Middleware] Redirecting to home");
  //   // Force redirect to home page for authenticated users on login page
  //   return NextResponse.redirect(new URL("/", request.url), {
  //     status: 307, // Temporary redirect to ensure it's followed
  //     headers: {
  //       "Cache-Control": "no-store, must-revalidate, max-age=0",
  //       Pragma: "no-cache",
  //     },
  //   });
  // }

  // // Continue with the request if none of the above conditions are met
  // console.log("[Middleware] Continuing with request");
  // return NextResponse.next();
}

// Configure which paths middleware should run on
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
