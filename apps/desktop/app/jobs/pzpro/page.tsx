import { JobsView } from "@/components/jobs-view";

export default function PZProJobsPage() {
  return (
    <JobsView
      queueLabel="PZPro"
      queueDescription="PZPro jobs assigned to this station, using the same order list and recovery workflow as Wink."
      sourceFilter="pzpro"
    />
  );
}
