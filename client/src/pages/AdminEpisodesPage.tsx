import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Edit2, Trash2, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export default function AdminEpisodesPage() {
  const [novelFilter, setNovelFilter] = useState<number | undefined>();
  const [openDialog, setOpenDialog] = useState(false);
  const [editingEpisode, setEditingEpisode] = useState<any>(null);
  const [formData, setFormData] = useState({
    novelId: 0,
    episodeNumber: 0,
    title: "",
    price: "0",
    isFree: false,
    fileUrl: "",
  });

  const { data: episodes, isLoading, refetch } = trpc.admin.getAllEpisodes.useQuery();
  const { data: novels } = trpc.novels.list.useQuery();

  const createMutation = trpc.admin.episodes.create.useMutation({
    onSuccess: () => {
      toast.success("Episode created successfully!");
      setOpenDialog(false);
      setFormData({ novelId: 0, episodeNumber: 0, title: "", price: "0", isFree: false, fileUrl: "" });
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create episode");
    },
  });

  const updateMutation = trpc.admin.episodes.update.useMutation({
    onSuccess: () => {
      toast.success("Episode updated successfully!");
      setOpenDialog(false);
      setEditingEpisode(null);
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update episode");
    },
  });

  const deleteMutation = trpc.admin.episodes.delete.useMutation({
    onSuccess: () => {
      toast.success("Episode deleted successfully!");
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete episode");
    },
  });

  const handleSubmit = () => {
    if (!formData.title || !formData.novelId) {
      toast.error("Title and novel are required");
      return;
    }

    if (editingEpisode) {
      updateMutation.mutate({
        episodeId: editingEpisode.id,
        episodeNumber: formData.episodeNumber,
        title: formData.title,
        price: formData.price,
        isFree: formData.isFree,
        fileUrl: formData.fileUrl,
      });
    } else {
      createMutation.mutate(formData as any);
    }
  };

  const handleEdit = (episode: any) => {
    setEditingEpisode(episode);
    setFormData({
      novelId: episode.novelId,
      episodeNumber: parseInt(episode.episodeNumber) || 0,
      title: episode.title,
      price: episode.price || "0",
      isFree: episode.isFree || false,
      fileUrl: episode.fileUrl || "",
    });
    setOpenDialog(true);
  };

  const filteredEpisodes = episodes?.filter((ep: any) =>
    !novelFilter || ep.novelId === novelFilter
  ) || [];

  return (
    <AdminLayout title="Manage Episodes">
      <div className="space-y-6">
        {/* Header with Filters and Create Button */}
        <div className="flex gap-4 items-center">
          <select
            value={novelFilter || ""}
            onChange={(e) => setNovelFilter(e.target.value ? parseInt(e.target.value) : undefined)}
            className="px-3 py-2 border rounded-md"
          >
            <option value="">All Novels</option>
            {novels?.map((novel: any) => (
              <option key={novel.id} value={novel.id}>
                {novel.title}
              </option>
            ))}
          </select>
          <Dialog open={openDialog} onOpenChange={setOpenDialog}>
            <DialogTrigger asChild>
              <Button
                onClick={() => {
                  setEditingEpisode(null);
                  setFormData({ novelId: 0, episodeNumber: 0, title: "", price: "0", isFree: false, fileUrl: "" });
                }}
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Episode
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingEpisode ? "Edit Episode" : "Create New Episode"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Novel</Label>
                  <select
                    value={formData.novelId}
                    onChange={(e) => setFormData({ ...formData, novelId: parseInt(e.target.value) })}
                    className="w-full px-3 py-2 border rounded-md"
                  >
                    <option value={0}>Select a novel</option>
                    {novels?.map((novel: any) => (
                      <option key={novel.id} value={novel.id}>
                        {novel.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Episode Number</Label>
                  <Input
                    type="number"
                    value={formData.episodeNumber}
                    onChange={(e) => setFormData({ ...formData, episodeNumber: parseInt(e.target.value) || 0 })}
                    placeholder="1"
                  />
                </div>
                <div>
                  <Label>Title</Label>
                  <Input
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="Episode title"
                  />
                </div>
                <div>
                  <Label>Price (฿)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isFree}
                    onChange={(e) => setFormData({ ...formData, isFree: e.target.checked })}
                    id="isFree"
                  />
                  <Label htmlFor="isFree">Free Episode</Label>
                </div>
                <div>
                  <Label>File URL</Label>
                  <Input
                    value={formData.fileUrl}
                    onChange={(e) => setFormData({ ...formData, fileUrl: e.target.value })}
                    placeholder="https://..."
                  />
                </div>
                <Button
                  onClick={handleSubmit}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="w-full"
                >
                  {createMutation.isPending || updateMutation.isPending ? (
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
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : filteredEpisodes.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No episodes found</p>
          </Card>
        ) : (
          <div className="grid gap-4">
            {filteredEpisodes.map((episode: any) => {
              const novel = novels?.find((n: any) => n.id === episode.novelId);
              return (
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
                        {novel?.title} • Episode {episode.episodeNumber}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(episode)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm("Are you sure you want to delete this episode?")) {
                            deleteMutation.mutate({ episodeId: episode.id });
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
