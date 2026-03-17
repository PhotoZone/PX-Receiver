import { JobsView } from "@/components/jobs-view";

export default function PZProJobsPage() {
  return (
    <JobsView
      queueLabel="PZPro"
      queueDescription="PZPro and related Photo Zone-family jobs now arrive through the shared photozone receiver source."
      sourceFilter="photozone"
    />
  );
}
