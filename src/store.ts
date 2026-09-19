import { create } from "zustand";
export const useUI = create<{
  time: number;
  seek: number;
  version: number;
  playing: boolean;
  selected: number | null;
  receiver: number;
  tau: number;
  raw: boolean;
  speed: number;
  query: string;
  seekTo: (t: number) => void;
}>((set) => ({
  time: 12000,
  seek: 12000,
  version: 0,
  playing: false,
  selected: 0,
  receiver: 0,
  tau: 0.7,
  raw: false,
  speed: 1,
  query: "",
  seekTo: (t) => set((s) => ({ time: t, seek: t, version: s.version + 1 })),
}));
