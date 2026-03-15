import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export default function AdminBannersPage() {
  // All hooks must be called at the top level, before any conditional returns
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    imageUrl: "",
    linkUrl: "",
    displayOrder: 0,
  });

  // Query hooks with enabled flag - they won't fetch until auth is resolved and user is admin
  const { data: banners, isLoading, refetch } = trpc.admin.banners.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  // Mutation hooks
  const createMutation = trpc.admin.banners.create.useMutation({
    onSuccess: () => {
      toast.success("Banner created!");
      setFormData({ title: "", description: "", imageUrl: "", linkUrl: "", displayOrder: 0 });
      setIsCreating(false);
      refetch();
    },
    onError: () => {
      toast.error("Failed to create banner");
    },
  });

  const deleteMutation = trpc.admin.banners.delete.useMutation({
    onSuccess: () => {
      toast.success("Banner deleted");
      refetch();
    },
    onError: () => {
      toast.error("Failed to delete banner");
    },
  });

  // Now perform auth checks after all hooks are declared
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please log in to access admin</p>
            <Button asChild>
              <a href="/">Go Home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
            <Button asChild>
              <a href="/">Go Home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleCreate = () => {
    if (!formData.title || !formData.imageUrl) {
      toast.error("Title and image URL are required");
      return;
    }
    createMutation.mutate(formData);
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Manage Banners</h1>
          <Button onClick={() => setIsCreating(!isCreating)}>
            <Plus className="w-4 h-4 mr-2" />
            New Banner
          </Button>
        </div>

        {/* Create Form */}
        {isCreating && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Create New Banner</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-semibold">Title</label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Banner title"
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Description</label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Banner description"
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Image URL</label>
                <Input
                  value={formData.imageUrl}
                  onChange={(e) => setFormData({ ...formData, imageUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Link URL (optional)</label>
                <Input
                  value={formData.linkUrl}
                  onChange={(e) => setFormData({ ...formData, linkUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Display Order</label>
                <Input
                  type="number"
                  value={formData.displayOrder}
                  onChange={(e) => setFormData({ ...formData, displayOrder: parseInt(e.target.value) })}
                />
              </div>

              <div className="flex gap-2 pt-4">
                <Button onClick={handleCreate} disabled={createMutation.isPending} className="flex-1">
                  Create Banner
                </Button>
                <Button variant="outline" onClick={() => setIsCreating(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Banners List */}
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : !banners || banners.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <p className="text-slate-600">No banners yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {banners.map((banner: any) => (
              <Card key={banner.id} className="overflow-hidden">
                <CardContent className="pt-6">
                  <div className="flex gap-4">
                    {banner.imageUrl && (
                      <img
                        src={banner.imageUrl}
                        alt={banner.title}
                        className="w-32 h-24 object-cover rounded"
                      />
                    )}
                    <div className="flex-1">
                      <h3 className="font-semibold text-slate-900">{banner.title}</h3>
                      <p className="text-sm text-slate-600 mt-1">{banner.description}</p>
                      {banner.linkUrl && (
                        <p className="text-xs text-blue-600 mt-2">{banner.linkUrl}</p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate({ bannerId: banner.id })}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
