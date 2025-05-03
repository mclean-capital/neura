"use client";

import React from "react";
import { usePlaygroundState } from "../hooks/use-playground-state";
import { ellipsisMiddle } from "../lib/utils";
import { signOutUser } from "../services/firebase";
import { useNavigate } from 'react-router';
import { ROUTE_PATHS } from "../main";

export function Auth() {
  const navigate = useNavigate();
  const { pgState, dispatch } = usePlaygroundState();

  const onLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dispatch({ type: "SET_API_KEY", payload: null });
    await signOutUser();
    navigate(ROUTE_PATHS.HOME);
  };

  return (
    <div>
      {pgState.openaiAPIKey && (
        <div className="text-xs flex gap-2 items-center">
          <span className="font-semibold text-neutral-700">
            Using OpenAI API Key
          </span>
          <div className="py-1 px-2 rounded-md bg-neutral-200 text-neutral-600">
            {ellipsisMiddle(pgState.openaiAPIKey, 4, 4)}
          </div>
          <a className="hover:underline cursor-pointer" onClick={onLogout}>
            Clear
          </a>
        </div>
      )}
    </div>
  );
}
