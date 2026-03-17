import { JobsView } from "@/components/jobs-view";

export default function PhotoZoneJobsPage() {
  return (
    <JobsView
      queueLabel="Photo Zone"
      queueDescription=""
      sourceFilter="photozone"
    />
  );
}
