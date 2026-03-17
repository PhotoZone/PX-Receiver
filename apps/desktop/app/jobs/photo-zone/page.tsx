import { JobsView } from "@/components/jobs-view";

export default function PhotoZoneJobsPage() {
  return (
    <JobsView
      queueLabel="Photo Zone"
      queueDescription="Photo Zone jobs assigned to this station for download, printing, completion, or recovery."
      sourceFilter="photozone"
    />
  );
}
