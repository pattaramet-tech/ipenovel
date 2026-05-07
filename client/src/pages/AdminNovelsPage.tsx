import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Edit2, Plus, Trash2, BookOpen, ChevronRight, Upload, X } from "lucide-react";
import { useState, useRef } from "react";
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
  const [publicationFilter, setPublicationFilter] = useState<"all" | "published" | "archived">("all");
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    coverImageUrl: "",
    publicationStatus: "published" as "published" | "archived",
    storyStatus: "ongoing" as "ongoing" | "finished",
  });
  const [selectedCoverFile, setSelectedCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const uploadCoverMutation = trpc.admin.novels.uploadCover.useMutation({
    onSuccess: (data) => {
      setFormData({ ...formData, coverImageUrl: data.url });
      setSelectedCoverFile(null);
      setCoverPreview(null);
      setIsUploadingCover(false);
      toast.success("Cover image uploaded!");
    },
    onError: (error) => {
      setIsUploadingCover(false);
      toast.error(error.message || "Failed to upload cover image");
    },
  });

  const handleCoverFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error("Please select a JPG, PNG, or WebP image");
      return;
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be 5MB or smaller");
      return;
    }

    setSelectedCoverFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (event) => {
      setCoverPreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleUploadCover = async () => {
    if (!selectedCoverFile) return;

    setIsUploadingCover(true);

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      uploadCoverMutation.mutate({
        fileName: selectedCoverFile.name,
        mimeType: selectedCoverFile.type as "image/jpeg" | "image/png" | "image/webp",
        fileBase64: base64,
      });
    };
    reader.readAsDataURL(selectedCoverFile);
  };

  const handleRemoveCover = () => {
    setFormData({ ...formData, coverImageUrl: "" });
    setSelectedCoverFile(null);
    setCoverPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

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

  const filteredNovels = novels?.filter((n: any) => {
    const matchesSearch = n.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = 
      publicationFilter === "all" ||
      (publicationFilter === "published" && n.publicationStatus === "published") ||
      (publicationFilter === "archived" && n.publicationStatus === "archived");
    return matchesSearch && matchesStatus;
  }) || [];

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
    setSelectedCoverFile(null);
    setCoverPreview(null);
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
    setSelectedCoverFile(null);
    setCoverPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
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
                  <label className="text-sm font-semibold text-slate-700 block mb-2">Cover Image</label>
                  <div className="space-y-3">
                    {/* File Input */}
                    <div className="flex items-center gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleCoverFileSelect}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex-1"
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Choose Image
                      </Button>
                      {selectedCoverFile && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleUploadCover}
                          disabled={isUploadingCover}
                          className="flex-1"
                        >
                          {isUploadingCover ? "Uploading..." : "Upload"}
                        </Button>
                      )}
                    </div>

                    {/* Selected File Info */}
                    {selectedCoverFile && (
                      <div className="text-sm text-slate-600">
                        Selected: {selectedCoverFile.name} ({(selectedCoverFile.size / 1024).toFixed(1)} KB)
                      </div>
                    )}

                    {/* Preview */}
                    {(coverPreview || formData.coverImageUrl) && (
                      <div className="space-y-2">
                        <p className="text-xs text-slate-600">Preview:</p>
                        <div className="flex items-end gap-3">
                          <SafeImage
                            src={coverPreview || formData.coverImageUrl}
                            alt="Cover preview"
                            className="w-20 h-28 object-cover rounded border border-slate-300"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleRemoveCover}
                            className="text-red-600 hover:text-red-700"
                          >
                            <X className="w-4 h-4 mr-1" />
                            Remove
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
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

        {/* Publication Status Filter */}
        <div className="flex gap-2 border-b border-slate-200">
          <button
            onClick={() => setPublicationFilter("all")}
            className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
              publicationFilter === "all"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            All Novels
          </button>
          <button
            onClick={() => setPublicationFilter("published")}
            className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
              publicationFilter === "published"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            Published
          </button>
          <button
            onClick={() => setPublicationFilter("archived")}
            className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
              publicationFilter === "archived"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            Archived
          </button>
        </div>

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
              <thead className="bg-slate-100 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-700">Title</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-700">Status</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-700">Story</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-slate-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredNovels.map((novel: any) => (
                  <tr key={novel.id} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {novel.coverImageUrl && (
                          <SafeImage
                            src={novel.coverImageUrl}
                            alt={novel.title}
                            className="w-10 h-14 object-cover rounded"
                          />
                        )}
                        <span className="font-medium text-slate-900">{novel.title}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                        novel.publicationStatus === "published"
                          ? "bg-green-100 text-green-800"
                          : "bg-yellow-100 text-yellow-800"
                      }`}>
                        {novel.publicationStatus === "published" ? "Published" : "Archived"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm text-slate-600 capitalize">{novel.storyStatus}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(novel)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/admin/novels/${novel.id}`)}
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (confirm("Delete this novel?")) {
                              deleteMutation.mutate({ novelId: novel.id });
                            }
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-red-600" />
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
