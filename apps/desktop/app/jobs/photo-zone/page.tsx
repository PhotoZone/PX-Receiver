import { JobsView } from "@/components/jobs-view";

export default function PhotoZoneJobsPage() {
  return (
    <JobsView
      queueLabel="Photo Zone"
      queueDescription="Photo Zone jobs assigned to this station, using the same order list and recovery workflow as Wink."
      sourceFilter="photo_zone"
    />
  );
}
