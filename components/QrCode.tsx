"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code rendered as inline SVG (no canvas, no external image), so it scales
 * crisply and prints. Uses the dependency-free `qrcode-generator` package.
 */
export function QrCode({
  value,
  size = 200,
  margin = 2,
  className,
}: {
  value: string;
  size?: number;
  margin?: number;
  className?: string;
}) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const moduleCount = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) d += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    return { count: moduleCount + margin * 2, path: d };
  }, [value, margin]);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      role="img"
      aria-label={value}
      shapeRendering="crispEdges"
      style={{ display: "block", borderRadius: 8, background: "#ffffff" }}
    >
      <rect width={count} height={count} fill="#ffffff" />
      <path d={path} fill="#111111" />
    </svg>
  );
}
