import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { ArrowLeft, Plus, Edit2, Trash2, Loader2, Search, ListVideo } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import SafeImage from "@/components/SafeImage";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

interface AdminNovelManagePageProps {
  params?: {
    novelId: string;
  };
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

export default function AdminNovelManagePage({ params }: AdminNovelManagePageProps) {
  const [, navigate] = useLocation();
  const novelId = parseInt(params?.novelId || "0");

  const [openEpisodeDialog, setOpenEpisodeDialog] = useState(false);
  const [editingEpisodeId, setEditingEpisodeId] = useState<number | null>(null);
  const [episodeFormData, setEpisodeFormData] = useState({
    episodeNumber: "",
    title: "",
    price: "0",
    isFree: false,
    fileUrl: "",
  });

  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearchTerm]);

  const utils = trpc.useUtils();

  // Lightweight novel detail - never fetches episodes (see admin.novels.detail).
  const { data: novel, isLoading: novelLoading } = trpc.admin.novels.detail.useQuery(
    { novelId },
    { enabled: novelId > 0 }
  );

  const episodesQueryInput = useMemo(
    () => ({
      novelId,
      page,
      pageSize: PAGE_SIZE,
      search: debouncedSearchTerm.trim() || undefined,
      // Preserve the original getEpisodesByNovelId() ordering (chapter order
      // within this one novel), unlike the cross-novel /admin/episodes page
      // which defaults to newest-first.
      sortBy: "episodeNumber" as const,
      sortOrder: "asc" as const,
    }),
    [novelId, page, debouncedSearchTerm]
  );

  // Paginated, backend-filtered, lightweight episode list scoped to this
  // novel only - never ships full episode content. See server/db.ts
  // getAdminEpisodesList.
  const { data: episodesData, isLoading: episodesLoading } = trpc.admin.episodes.list.useQuery(
    episodesQueryInput,
    { enabled: novelId > 0 }
  );
  const novelEpisodes = episodesData?.episodes ?? [];
  const total = episodesData?.total ?? 0;
  const totalPages = episodesData?.totalPages ?? 1;

  // Full episode row (content/fileUrl) is only fetched once an admin opens
  // the Edit dialog for a specific episode.
  const { data: episodeDetail, isLoading: detailLoading } = trpc.admin.episodes.detail.useQuery(
    { episodeId: editingEpisodeId! },
    { enabled: !!editingEpisodeId }
  );

  useEffect(() => {
    if (!episodeDetail) return;
    setEpisodeFormData({
      episodeNumber: String(episodeDetail.episodeNumber) || "",
      title: episodeDetail.title || "",
      price: episodeDetail.price || "0",
      isFree: episodeDetail.isFree || false,
      fileUrl: episodeDetail.fileUrl || "",
    });
  }, [episodeDetail]);

  const invalidateEpisodeQueries = () => {
    utils.admin.episodes.list.invalidate();
    utils.admin.novels.detail.invalidate({ novelId });
  };

  // Mutations
  const createEpisodeMutation = trpc.admin.episodes.create.useMutation({
    onSuccess: () => {
      toast.success("Episode created successfully!");
      setOpenEpisodeDialog(false);
      setEpisodeFormData({ episodeNumber: "", title: "", price: "0", isFree: false, fileUrl: "" });
      invalidateEpisodeQueries();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create episode");
    },
  });

  const updateEpisodeMutation = trpc.admin.episodes.update.useMutation({
    onSuccess: () => {
      toast.success("Episode updated successfully!");
      setOpenEpisodeDialog(false);
      setEditingEpisodeId(null);
      setEpisodeFormData({ episodeNumber: "", title: "", price: "0", isFree: false, fileUrl: "" });
      invalidateEpisodeQueries();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update episode");
    },
  });

  const deleteEpisodeMutation = trpc.admin.episodes.delete.useMutation({
    onSuccess: () => {
      toast.success("Episode deleted successfully!");
      invalidateEpisodeQueries();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete episode");
    },
  });

  if (!novelId) {
    return (
      <AdminLayout>
        <div className="text-center py-12">
          <p className="text-slate-600">Invalid novel ID</p>
        </div>
      </AdminLayout>
    );
  }

  if (novelLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </AdminLayout>
    );
  }

  if (!novel) {
    return (
      <AdminLayout>
        <div className="text-center py-12">
          <p className="text-slate-600">Novel not found</p>
        </div>
      </AdminLayout>
    );
  }

  const handleEpisodeSubmit = () => {
    if (!episodeFormData.title) {
      toast.error("Title is required");
      return;
    }

    if (editingEpisodeId) {
      updateEpisodeMutation.mutate({
        episodeId: editingEpisodeId,
        episodeNumber: episodeFormData.episodeNumber,
        title: episodeFormData.title,
        price: episodeFormData.price,
        isFree: episodeFormData.isFree,
        fileUrl: episodeFormData.fileUrl,
      });
    } else {
      createEpisodeMutation.mutate({
        novelId,
        ...episodeFormData,
      });
    }
  };

  const handleEditEpisode = (episode: any) => {
    setEditingEpisodeId(episode.id);
    setOpenEpisodeDialog(true);
  };

  const handleCloseEpisodeDialog = () => {
    setOpenEpisodeDialog(false);
    setEditingEpisodeId(null);
    setEpisodeFormData({ episodeNumber: "", title: "", price: "0", isFree: false, fileUrl: "" });
  };

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/admin/novels")}
            className="gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Novels
          </Button>
        </div>

        {/* Novel Info Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex gap-6">
              <SafeImage
                src={novel.novel.coverImageUrl || undefined}
                alt={novel.novel.title}
                className="w-24 h-32 object-cover rounded"
              />
              <div className="flex-1">
                <h1 className="text-2xl font-bold text-slate-900">{novel.novel.title}</h1>
                <p className="text-slate-600 mt-2">{novel.novel.description}</p>
                <div className="flex gap-2 mt-4">
                  <Badge variant={novel.novel.publicationStatus === "published" ? "default" : "secondary"}>
                    {novel.novel.publicationStatus === "published" ? "Published" : "Archived"}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={novel.novel.storyStatus === "finished"
                      ? "bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-100"
                      : "bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100"
                    }
                  >
                    {novel.novel.storyStatus === "finished" ? "Finished" : "Ongoing"}
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Episodes Section */}
        <div>
          <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
            <h2 className="text-2xl font-bold text-slate-900">Episodes</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => navigate(`/admin/episodes/${novelId}`)}
                className="gap-2"
              >
                <ListVideo className="w-4 h-4" />
                จัดการตอนทั้งหมด
              </Button>
              <Dialog open={openEpisodeDialog} onOpenChange={(open) => (open ? setOpenEpisodeDialog(true) : handleCloseEpisodeDialog())}>
                <DialogTrigger asChild>
                  <Button
                    onClick={() => {
                      setEditingEpisodeId(null);
                      setEpisodeFormData({
                        episodeNumber: "",
                        title: "",
                        price: "0",
                        isFree: false,
                        fileUrl: "",
                      });
                    }}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Episode
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>{editingEpisodeId ? "Edit Episode" : "Add New Episode"}</DialogTitle>
                  </DialogHeader>
                  {editingEpisodeId && detailLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                    </div>
                  ) : (
                  <div className="space-y-4">
                    <div>
                      <Label>Episode Number</Label>
                      <Input
                        type="text"
                        value={episodeFormData.episodeNumber}
                        onChange={(e) =>
                          setEpisodeFormData({ ...episodeFormData, episodeNumber: e.target.value })
                        }
                        placeholder="e.g., 001 - 030 or 1"
                      />
                    </div>
                    <div>
                      <Label>Title</Label>
                      <Input
                        value={episodeFormData.title}
                        onChange={(e) =>
                          setEpisodeFormData({ ...episodeFormData, title: e.target.value })
                        }
                        placeholder="Episode title"
                      />
                    </div>
                    <div>
                      <Label>Price (฿)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={episodeFormData.price}
                        onChange={(e) =>
                          setEpisodeFormData({ ...episodeFormData, price: e.target.value })
                        }
                        placeholder="0.00"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={episodeFormData.isFree}
                        onChange={(e) =>
                          setEpisodeFormData({ ...episodeFormData, isFree: e.target.checked })
                        }
                        id="isFree"
                      />
                      <Label htmlFor="isFree">Free Episode</Label>
                    </div>
                    <div>
                      <Label>File URL</Label>
                      <Input
                        value={episodeFormData.fileUrl}
                        onChange={(e) =>
                          setEpisodeFormData({ ...episodeFormData, fileUrl: e.target.value })
                        }
                        placeholder="https://..."
                      />
                    </div>
                    <Button
                      onClick={handleEpisodeSubmit}
                      disabled={
                        createEpisodeMutation.isPending || updateEpisodeMutation.isPending
                      }
                      className="w-full"
                    >
                      {createEpisodeMutation.isPending || updateEpisodeMutation.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                  )}
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by title or episode number..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Episodes List */}
          {episodesLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
            </div>
          ) : novelEpisodes.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-muted-foreground">
                {searchTerm.trim() ? "No episodes match your search" : "No episodes yet. Add one to get started."}
              </p>
            </Card>
          ) : (
            <div className="grid gap-4">
              <div className="text-sm text-muted-foreground">
                Showing {rangeStart}-{rangeEnd} of {total} episode{total !== 1 ? "s" : ""}
              </div>
              {novelEpisodes.map((episode: any) => (
                <Card key={episode.id} className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-lg">{episode.title}</h3>
                        <Badge variant={episode.isFree ? "default" : "secondary"}>
                          {episode.isFree ? "Free" : `฿${episode.price}`}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Episode {episode.episodeNumber}
                      </p>
                      {episode.hasLegacyFile && (
                        <p className="text-xs text-slate-500 mt-1">Legacy file attached</p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditEpisode(episode)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm("Are you sure you want to delete this episode?")) {
                            deleteEpisodeMutation.mutate({ episodeId: episode.id });
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}

              {/* Pagination */}
              <div className="flex justify-center items-center gap-4 mt-2">
                <Button
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-600">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
