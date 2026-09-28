import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, ogImageElement } from "../../lib/ogImage";

export const alt = "OpenGlass pricing — the core protocol is free";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(ogImageElement("Pricing", "The core protocol is free. No account tiers."), size);
}
