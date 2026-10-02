"use client";

import { createContext, useContext } from "react";
import type { Owner } from "./dashboard";

/** The signed-in owner, loaded once by the app shell (app/dashboard/layout.tsx). Pages
 * under /dashboard only render after it has loaded, so `owner` is never null there. */
export interface OwnerContextValue {
  owner: Owner;
  setOwner: (owner: Owner) => void;
}

export const OwnerContext = createContext<OwnerContextValue | null>(null);

export function useOwner(): OwnerContextValue {
  const value = useContext(OwnerContext);
  if (!value) throw new Error("useOwner must be used inside the /dashboard app shell");
  return value;
}
