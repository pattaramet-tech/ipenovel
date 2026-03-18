import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Edit2, Plus, Trash2, BookOpen, ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionHeader, StatusBadge, EmptyState, FormSection } from "@/components/AdminComponents";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import SafeImage from "@/components/SafeImage";

export default function AdminNovelsPage() {
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [isCreating, setIsCreating] = useState(false);
  const [editingNovelId, setEditingNovelId] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    coverImageUrl: "",
    publicationStatus: "published" as "published" | "archived",
    storyStatus: "ongoing" as "ongoing" | "finished",
  });

  const { data: novels, isLoading, refetch } = trpc.admin.novels.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  const createMutation = trpc.admin.novels.create.useMutation({
    onSuccess: () => {
      toast.success("Novel created!");
      setFormData({ title: "", description: "", coverImageUrl: "", publicationStatus: "published", storyStatus: "ongoing" });
      setIsCreating(false);
      refetch();
    },
    onError: () => {
      toast.error("Failed to create novel");
    },
  });

  const updateMutation = trpc.admin.novels.update.useMutation({
    onSuccess: () => {
      toast.success("Novel updated!");
      setFormData({ title: "", description: "", coverImageUrl: "", publicationStatus: "published", storyStatus: "ongoing" });
      setEditingNovelId(null);
      refetch();
    },
    onError: () => {
      toast.error("Failed to update novel");
    },
  });

  const deleteMutation = trpc.admin.novels.delete.useMutation({
    onSuccess: () => {
      toast.success("Novel deleted");
      refetch();
    },
    onError: () => {
      toast.error("Failed to delete novel");
    },
  });

  if (!isAuthenticated || user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const filteredNovels = novels?.filter((n: any) =>
    n.title.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const handleCreate = () => {
    if (!formData.title) {
      toast.error("Title is required");
      return;
    }
    createMutation.mutate(formData);
  };

  const handleEdit = (novel: any) => {
    setEditingNovelId(novel.id);
    setFormData({
      title: novel.title,
      description: novel.description || "",
      coverImageUrl: novel.coverImageUrl || "",
      publicationStatus: novel.publicationStatus || "published",
      storyStatus: novel.storyStatus || "ongoing",
    });
  };

  const handleSaveEdit = () => {
    if (!formData.title) {
      toast.error("Title is required");
      return;
    }
    if (editingNovelId) {
      updateMutation.mutate({
        novelId: editingNovelId,
        ...formData,
      });
    }
  };

  const handleCancel = () => {
    setIsCreating(false);
    setEditingNovelId(null);
    setFormData({ title: "", description: "", coverImageUrl: "", publicationStatus: "published", storyStatus: "ongoing" });
  };

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Novels</h1>
            <p className="text-slate-600 mt-1">Manage your novel catalog</p>
          </div>
          <Button onClick={() => setIsCreating(!isCreating)} size="lg">
            <Plus className="w-5 h-5 mr-2" />
            New Novel
          </Button>
        </div>

        {/* Create/Edit Form */}
        {(isCreating || editingNovelId) && (
          <Card className="border-blue-200 bg-blue-50">
            <CardHeader>
              <CardTitle>{editingNovelId ? "Edit Novel" : "Create New Novel"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormSection title="Basic Information">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700 block mb-2">Title *</label>
                    <Input
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                      placeholder="Enter novel title"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 block mb-2">Publication Status</label>
                    <select
                      value={formData.publicationStatus}
                      onChange={(e) => setFormData({ ...formData, publicationStatus: e.target.value as any })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="published">Published (Visible)</option>
                      <option value="archived">Archived (Hidden)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 block mb-2">Story Status</label>
                    <select
                      value={formData.storyStatus}
                      onChange={(e) => setFormData({ ...formData, storyStatus: e.target.value as any })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="ongoing">Ongoing</option>
                      <option value="finished">Finished</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 block mb-2">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Enter novel description"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    rows={4}
                  />
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 block mb-2">Cover Image URL</label>
                  <Input
                    value={formData.coverImageUrl}
                    onChange={(e) => setFormData({ ...formData, coverImageUrl: e.target.value })}
                    placeholder="https://..."
                  />
                  {formData.coverImageUrl && (
                    <div className="mt-2">
                      <p className="text-xs text-slate-600 mb-2">Preview:</p>
                      <SafeImage
                        src={formData.coverImageUrl}
                        alt="Cover preview"
                        className="w-20 h-28 object-cover rounded"
                      />
                    </div>
                  )}
                </div>
              </FormSection>

              <div className="flex gap-2 pt-4 border-t">
                <Button
                  onClick={editingNovelId ? handleSaveEdit : handleCreate}
                  disabled={createMutation.isPending || updateMutation.isPending}
                  className="flex-1"
                >
                  {editingNovelId ? "Save Changes" : "Create Novel"}
                </Button>
                <Button variant="outline" onClick={handleCancel} className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search Bar */}
        <div className="flex gap-4">
          <Input
            placeholder="Search by title..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="max-w-md"
          />
        </div>

        {/* Novels Table */}
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : !filteredNovels || filteredNovels.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No Novels"
            description={searchTerm ? "No novels match your search" : "No novels yet. Create one to get started"}
            action={!searchTerm ? <Button onClick={() => setIsCreating(true)}>Create First Novel</Button> : undefined}
          />
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Cover</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Title</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Publication</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Story</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Updated</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-700 text-sm">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredNovels.map((novel: any) => (
                  <tr key={novel.id} className="border-b hover:bg-slate-50 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <SafeImage
                        src={novel.coverImageUrl}
                        alt={novel.title}
                        className="w-10 h-14 object-cover rounded"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium text-slate-900">{novel.title}</p>
                        <p className="text-xs text-slate-600">{novel.description?.substring(0, 40)}...</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={novel.publicationStatus} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={novel.storyStatus} />
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {new Date(novel.updatedAt || novel.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/admin/novels/${novel.id}`)}
                          title="Manage novel and episodes"
                        >
                          Manage
                          <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(novel)}
                          title="Edit novel details"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm("Delete this novel?")) {
                              deleteMutation.mutate({ novelId: novel.id });
                            }
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
