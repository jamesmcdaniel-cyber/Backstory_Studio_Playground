import { redirect } from 'next/navigation'

// The ROI page folded into Artifacts: an ROI dashboard is an artifact with
// versions and an assistant. Old links land on the ROI dashboards there.
export default function RoiPage() {
  redirect('/artifacts?kind=roi_dashboard')
}
