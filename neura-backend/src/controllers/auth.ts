import { Request, Response } from "express";
import { generateToken, verifyGoogleToken } from "../middleware/auth";
import config from "../config";

/**
 * Handle Google authentication
 * @param req Express request
 * @param res Express response
 */
export async function googleAuth(req: Request, res: Response) {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "ID token is required" });
    }

    // Verify Google ID token
    const user = await verifyGoogleToken(idToken);

    if (!user) {
      return res.status(401).json({ error: "Invalid Google ID token" });
    }

    // Check if email is allowed
    if (user.email !== config.allowedEmail) {
      return res.status(403).json({
        error: "Access denied. You are not authorized to use this application.",
      });
    }

    // Generate JWT token
    const token = generateToken(user);

    // Return user info and token
    res.json({
      token,
      user: {
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
    });
  } catch (error) {
    console.error("Google authentication error:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
}

/**
 * Verify if a user's token is valid
 * @param req Express request
 * @param res Express response
 */
export function verifyAuth(req: Request, res: Response) {
  // If the request reaches this point, it means the auth middleware has already
  // validated the token, so we can just return the user info from the request
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    user: {
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
    },
  });
}
