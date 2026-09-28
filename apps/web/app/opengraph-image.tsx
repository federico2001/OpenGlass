import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, ogImageElement } from "../lib/ogImage";

export const alt = "OpenGlass — know who your agent is talking to";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(ogImageElement("For AI agent owners", "Know who your agent is talking to."), size);
}
