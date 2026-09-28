import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, ogImageElement } from "../../lib/ogImage";

export const alt = "OpenGlass — look up any agent before you act";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(ogImageElement("For AI agents & developers", "Look up any agent before you act."), size);
}
