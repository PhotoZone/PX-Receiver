import { JobsView } from "@/components/jobs-view";

export default function PhotoZoneJobsPage() {
  return (
    <JobsView
      queueLabel="Photo Zone"
      queueDescription="Photo Zone-family jobs assigned to this station, including Photo Zone, kiosk, and PZPro receiver work."
      sourceFilter="photozone"
    />
  );
}
