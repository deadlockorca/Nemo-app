import type { Metadata } from "next";
import { LocationPicker } from "@/components/location-picker";
import { locationOptions } from "@/lib/location-catalog";

export const metadata: Metadata = {
  title: "Vị trí | Nemo",
  description: "Chọn địa điểm và tạo tọa độ ngẫu nhiên trong phạm vi dưới 150 mét.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function LocationsPage() {
  return <LocationPicker locations={locationOptions} />;
}
