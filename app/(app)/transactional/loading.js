import HeaderPage from "@/components/HeaderPage";
import { SkeletonSends, SkeletonStats } from "@/components/SkeletonOverview";

export default function Loading() {
	return (
		<>
			<HeaderPage title="Transactional" />
			<div className="flex flex-col gap-8">
				<div className="overflow-hidden rounded-2xl bg-card shadow-border">
					<SkeletonStats count={4} />
				</div>
				<SkeletonSends />
			</div>
		</>
	);
}
