import express from "express";
import { AccessToken } from "livekit-server-sdk";

const tokenRouter = express.Router();

// POST /token
tokenRouter.post("/", async (req, res) => {
  try {
    const roomName = Math.random().toString(36).slice(7);
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set");
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: "human",
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });
    return res.json({
      accessToken: await at.toJwt(),
      url: process.env.LIVEKIT_URL,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    let errorMessage = `Failed to retrieve token`;
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    console.error(`Error:`, error);
    // #swagger.responses[500] = { schema: { message: 'Failed to retrieve play history entry' } }
    return res.status(500).json({ message: errorMessage }).end();
  }
});

export default tokenRouter;
