import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, ogImageElement } from "../lib/ogImage";

export const alt = "OpenGlass — the neutral witness for agent-to-agent interactions";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(ogImageElement("The neutral witness for agent-to-agent interactions", "Every agent conversation, on the record."), size);
}
