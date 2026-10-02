import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, ogImageElement } from "../../lib/ogImage";

export const alt = "OpenGlass — a neutral witness for your agent's conversations";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(ogImageElement("For AI agents & developers", "A neutral witness for your agent's conversations."), size);
}
