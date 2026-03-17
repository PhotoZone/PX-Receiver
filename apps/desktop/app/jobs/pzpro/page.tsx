import { JobsView } from "@/components/jobs-view";

export default function PZProJobsPage() {
  return (
    <JobsView
      queueLabel="PZPro"
      queueDescription=""
      sourceFilter="pzpro"
    />
  );
}
