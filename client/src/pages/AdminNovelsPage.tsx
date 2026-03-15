import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Edit2, Plus, Trash2, BookOpen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SectionHeader, StatusBadge, EmptyState, FormSection } from "@/components/AdminComponents";
import { useAuth } from "@/_core/hooks/useAuth";

export default function AdminNovelsPage() {
  const { user, isAuthenticated } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [formData, setFormData] = useState({
    title: "",
    author: "",
    description: "",
    coverImageUrl: "",
    status: "draft" as "draft" | "published" | "archived",
  });

  const { data: novels, isLoading, refetch } = trpc.admin.novels.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  const createMutation = trpc.admin.novels.create.useMutation({
    onSuccess: () => {
      toast.success("Novel created!");
      setFormData({ title: "", author: "", description: "", coverImageUrl: "", status: "draft" });
      setIsCreating(false);
      refetch();
    },
    onError: () => {
      toast.error("Failed to create novel");
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
    n.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    n.author.toLowerCase().includes(searchTerm.toLowerCase())
  ) || [];

  const handleCreate = () => {
    if (!formData.title || !formData.author) {
      toast.error("Title and author are required");
      return;
    }
    createMutation.mutate(formData);
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

        {/* Create Form */}
        {isCreating && (
          <Card className="border-blue-200 bg-blue-50">
            <CardHeader>
              <CardTitle>Create New Novel</CardTitle>
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
                    <label className="text-sm font-semibold text-slate-700 block mb-2">Author *</label>
                    <Input
                      value={formData.author}
                      onChange={(e) => setFormData({ ...formData, author: e.target.value })}
                      placeholder="Enter author name"
                    />
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
                </div>
              </FormSection>

              <div className="flex gap-2 pt-4 border-t">
                <Button onClick={handleCreate} disabled={createMutation.isPending} className="flex-1">
                  Create Novel
                </Button>
                <Button variant="outline" onClick={() => setIsCreating(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search Bar */}
        <div className="flex gap-4">
          <Input
            placeholder="Search by title or author..."
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
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Title</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Author</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Status</th>
                  <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Created</th>
                  <th className="text-right px-4 py-3 font-semibold text-slate-700 text-sm">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredNovels.map((novel: any) => (
                  <tr key={novel.id} className="border-b hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {novel.coverImageUrl && (
                          <img
                            src={novel.coverImageUrl}
                            alt={novel.title}
                            className="w-10 h-14 object-cover rounded"
                          />
                        )}
                        <div>
                          <p className="font-medium text-slate-900">{novel.title}</p>
                          <p className="text-xs text-slate-600">{novel.description?.substring(0, 40)}...</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{novel.author}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={novel.status} />
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {new Date(novel.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
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
