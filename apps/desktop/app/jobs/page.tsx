import { JobsView } from "@/components/jobs-view";

export default function JobsPage() {
  return (
    <JobsView
      queueLabel="Wink"
      queueDescription="Wink jobs assigned to this station for download, printing, completion, or recovery."
      sourceFilter="wink"
    />
  );
}
