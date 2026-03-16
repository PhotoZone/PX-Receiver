import { JobsView } from "@/components/jobs-view";

export default function UnifiedJobsPage() {
  return (
    <JobsView
      queueLabel="Order Queue"
      queueDescription="All assigned jobs across Wink, Photo Zone, and PZPro in one view."
    />
  );
}
