import { JobsView } from "@/components/jobs-view";

export default function PZProJobsPage() {
  return (
    <JobsView
      queueLabel="PZPro"
      queueDescription="PZPro jobs assigned to this station for download, printing, completion, or recovery."
      sourceFilter="pzpro"
    />
  );
}
