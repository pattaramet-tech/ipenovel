import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { ArrowLeft, Plus, Edit2, Trash2, Loader2 } from "lucide-react";
import { useState } from "react";
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

  // Queries
  const { data: novel, isLoading: novelLoading } = trpc.novels.detail.useQuery(
    { novelId },
    { enabled: novelId > 0 }
  );

  const { data: episodes, refetch: refetchEpisodes } = trpc.admin.getAllEpisodes.useQuery(
    undefined,
    { enabled: novelId > 0 }
  );

  // Mutations
  const createEpisodeMutation = trpc.admin.episodes.create.useMutation({
    onSuccess: () => {
      toast.success("Episode created successfully!");
      setOpenEpisodeDialog(false);
      setEpisodeFormData({ episodeNumber: "", title: "", price: "0", isFree: false, fileUrl: "" });
      refetchEpisodes();
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
      refetchEpisodes();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update episode");
    },
  });

  const deleteEpisodeMutation = trpc.admin.episodes.delete.useMutation({
    onSuccess: () => {
      toast.success("Episode deleted successfully!");
      refetchEpisodes();
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

  const novelEpisodes = episodes?.filter((ep: any) => ep.novelId === novelId) || [];

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
    setEpisodeFormData({
      episodeNumber: String(episode.episodeNumber) || "",
      title: episode.title,
      price: episode.price || "0",
      isFree: episode.isFree || false,
      fileUrl: episode.fileUrl || "",
    });
    setOpenEpisodeDialog(true);
  };

  const handleCloseEpisodeDialog = () => {
    setOpenEpisodeDialog(false);
    setEditingEpisodeId(null);
    setEpisodeFormData({ episodeNumber: "", title: "", price: "0", isFree: false, fileUrl: "" });
  };

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
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-slate-900">Episodes</h2>
            <Dialog open={openEpisodeDialog} onOpenChange={setOpenEpisodeDialog}>
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
              </DialogContent>
            </Dialog>
          </div>

          {/* Episodes List */}
          {novelEpisodes.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-muted-foreground">No episodes yet. Add one to get started.</p>
            </Card>
          ) : (
            <div className="grid gap-4">
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
                      {episode.fileUrl && (
                        <p className="text-xs text-slate-500 mt-1 truncate">
                          File: {episode.fileUrl}
                        </p>
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
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
